/**
 * To anyone reading the source - we're using this to track exit pages in google analytics
 * It's aggregate data, not identifying! 
 * @param {Object} url
 */
function trackOutboundLink(url) {
   ga('send', 'event', 'outbound', 'click', url);
}

$.fn.applyRating = function() {
    return $(this).each(function() {
    	if ($(this).html()) {
	        var val = parseFloat($(this).html());
	        var size = (Math.max(0, (Math.min(100, val)))/10) * 17;
	        var $span = $('<span />').width(size);
	        $(this).html($span);
       }
    });
};

$.fn.applyStream = function() {
	return $(this).each(function() {
		checkStream($(this).text());
	});
};

function checkStream(username) {
	$.getJSON( "https://api.twitch.tv/kraken/streams/"+username+"?client_id=kqr7lsclgr9wo9xsmtyv22jl1pagdwj&callback=?", function( data ) {
		if (data["stream"] !== null) { //online
			image_url = data["stream"]["preview"]["medium"];
			stream_title = data["stream"]["channel"]["status"];
			fill_stream_box(username,true,image_url,stream_title);
		} else { //offline
			$.getJSON( "https://api.twitch.tv/kraken/channels/"+username+"?client_id=kqr7lsclgr9wo9xsmtyv22jl1pagdwj&callback=?", function( data2 ) {
				image_url = data2["logo"];
				stream_title = data2["status"];
				fill_stream_box(username,false,image_url,stream_title);
			});
		}
	});
}
			
function fill_stream_box(username, online, image_url, stream_title) {
	elem = $("a.stream-link:contains('"+username+"')");
	elem.attr("class","stream-link-detailed");
	elem.html('');
	
	table = $("<table/>");
		tr = $("<tr/>");
			td = $('<td/>');
			td.attr("style","width:1%;");
				img = $("<img/>");
				img.attr('src',image_url);
				img.attr('class','stream-preview');
				td.append(img);
			tr.append(td);
			td = $('<td/>');
				span = $('<span/>');
					span.attr("style","font-weight:bold");
					span.html(username);
					td.append(span);
					td.append(" playing:");
					td.append($("<br/>"));
					td.append(stream_title);
					td.append($("<br/>"));
					td.append((online?"Live Now!":"Not Live"));
			tr.append(td);
		table.append(tr);
	elem.append(table);
}

function submitlike(rid,ele,val) {
	//$('.clear_alert').hide();
	var req = {};
	req['method'] = 'like';
	req['val'] = val;
	req['id'] = rid;
	$.post( "/ratings/ratings_api.php", req).done(function( data ) {
		console.log(data);
		var rsp = $.parseJSON(data);
		if (rsp.success) {
			if (val==1) $(ele).siblings('#unlikebtn').show();
			else $(ele).siblings('#likebtn').show();
			
			$count_span = $(ele).siblings('.r-like-span');
			$count_span.html(parseInt($count_span.html())+(val==1?1:-1));
			$count_span_lbl = $(ele).siblings('.r-like-span-label');
			$count_span_lbl.html($count_span.html()==1?'Like':'Likes');
			
			$(ele).hide();
		}
		return rsp.success;
	});    
};

function review_setup(items) {
	$(items).find("#likebtn, #unlikebtn").click(
      function(event) {
        event.preventDefault();
      }
    );
    
    $(items).find('span.stars, span.hearts').applyRating();
    
    $(items).find(".review-text").each(function() {
        var th = 0;
        // measure how tall inside should be by adding together heights of all inside paragraphs (except read-more paragraph)
        $(this).children("span").each(function() {
            th += $(this).outerHeight();
        });
        if (th <= 120) { //match this with the max-height in the review-text2 class
            $(this).children("p.read-more").remove();
        } else {
            $(this).addClass("review-text2");
        }
    });
    
	$(items).find(".read-more .button").click(function(e) {
	  e.preventDefault();
	  totalHeight = 0;
	
	  var $el = $(this);
	  var $p  = $el.parent();
	  var $up = $p.parent();
	  var $ps = $up.children();
	  
	  // measure how tall inside should be by adding together heights of all inside paragraphs (except read-more paragraph)
	  $ps.each(function() {
	    totalHeight += $(this).outerHeight();
	  });
	        
	  $up.css({
	      // Set height to prevent instant jumpdown when max height is removed
	      "height": $up.height(),
	      "max-height": 700,
	      "overflow-y": "auto"
	    })
	    .animate({
	      "height": totalHeight
	    });
	  
	  // fade out read-more
	  $p.fadeOut();
	  
	  // prevent jump-down
	  return false;
	    
	});
}

function getRotationDegrees(obj) {
    var matrix = obj.css("-webkit-transform") ||
    obj.css("-moz-transform")    ||
    obj.css("-ms-transform")     ||
    obj.css("-o-transform")      ||
    obj.css("transform");
    if(matrix !== 'none') {
        var values = matrix.split('(')[1].split(')')[0].split(',');
        var a = values[0];
        var b = values[1];
        var angle = Math.round(Math.atan2(b, a) * (180/Math.PI));
    } else { var angle = 0; }
    return (angle < 0) ? angle + 360 : angle;
}

function moveSnowflakes() {
	var currentTime = new Date().getTime();
    $(".snowflake").each(function(){
	    var deg = getRotationDegrees($(this));
	    deg+=2;
	    $(this).css({
		  '-webkit-transform' : 'rotate(' + deg + 'deg)',
		  '-moz-transform'    : 'rotate(' + deg + 'deg)',
		  '-ms-transform'     : 'rotate(' + deg + 'deg)',
		  '-o-transform'      : 'rotate(' + deg + 'deg)',
		  'transform'         : 'rotate(' + deg + 'deg)'
		});
		
        //var newheight = parseInt($(this).css('top'))+4;
        //new absolute positioning based on delta time
        var newheight = -50 + (currentTime-$(this).data("start"))*0.05;
        if (newheight > $(document).height()-100) {
            $(this).remove();
        } else {
            $(this).css({ top: newheight+'px' });
        }
    });
    setTimeout(moveSnowflakes, 70);
}
function makeSnowflakes() {
    var newelement = $("<div></div>");
    newelement.addClass("snowflake");
    newelement.css("background-image","url(/images/snowflakes/sn"+(Math.floor(Math.random()*7)+1)+".png)");
    newelement.css("left",Math.floor(Math.random()*parseInt($(window).width()))+"px");

    newelement.css("top","-50px");
    newelement.css("z-index","4");
    newelement.css("position","absolute");
    newelement.css("width","48px");
    newelement.css("height","49px");
    
    newelement.data("start", new Date().getTime());
    
    $('body').prepend(newelement);

    setTimeout(makeSnowflakes, 750);
}

$(document).ready(function() {
	$('.stream-link').applyStream();
	review_setup($('.review'));
	
	$("span.spoiler").hide();
  	$('<span class="reveal">'+txtRevealSpoiler+'</span> ').insertBefore('.spoiler');
	$("span.reveal").click(function(){
		$(this).next("span.spoiler").fadeIn(2500);
		$(this).fadeOut(600);
		
	  	totalHeight = 0;
	  	//var $el = $(this);
	  	var $p  = $(this);
	  	var $up = $p.parent().parent();
	  	var $ps = $up.children();
	  
	  	// measure how tall inside should be by adding together heights of all inside paragraphs (except read-more paragraph)
	  	$ps.each(function() {
	    	totalHeight += $(this).outerHeight();
	  	});
	        
	  	$up.css({
	      // Set height to prevent instant jumpdown when max height is removed
	      "height": $up.height(),
	      "max-height": 9999
	    })
	    .animate({
	      "height": totalHeight
	    });
	  
	  	// fade out read-more
	  	$p.fadeOut();
	  
	  	// prevent jump-down
	  	return false;
	    
	});
	
	//setTimeout(moveSnowflakes, 70);
	//setTimeout(makeSnowflakes, 750);
	
	$('#language').change(function() {
		$('#language').parent().submit();
	});
	$('#language').siblings('input').remove();
});